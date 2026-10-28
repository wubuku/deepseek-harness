/** Real Chrome Workers verify local writes and interrupted downloads while another Worker waits for the Workspace lock. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const playwright = await import(process.env.DSH_POC_PLAYWRIGHT_MODULE ?? require.resolve('playwright'))
const { chromium } = playwright.default ?? playwright
const sourceDirectory = fileURLToPath(new URL('../', import.meta.url))
const timeout = Number(process.env.DSH_POC_STORE_CONCURRENCY_TIMEOUT_MS ?? 30_000)
assert.ok(Number.isSafeInteger(timeout) && timeout > 0, 'The concurrency timeout must be a positive integer')
const label = process.env.DSH_POC_STORE_CONCURRENCY_LABEL ?? 'current'
const selectedScenarios = process.env.DSH_POC_STORE_CONCURRENCY_SCENARIOS?.split(',')
assert.match(label, /^[a-zA-Z0-9_-]+$/, 'The artifact label must be a filename component')
const artifactDirectory = process.env.DSH_POC_STORE_CONCURRENCY_ARTIFACT_DIR === undefined
  ? await mkdtemp(join(tmpdir(), 'dsh-store-write-concurrency-'))
  : resolve(process.env.DSH_POC_STORE_CONCURRENCY_ARTIFACT_DIR)
await mkdir(artifactDirectory, { recursive: true })
const resultFile = join(artifactDirectory, `${label}-results.json`)
const sourceFiles = ['browser-native-workspace-store.ts', 'browser-native-download-journal.ts', 'browser-native-sha256.ts']
const evidence = {
  result: 'running', browser: 'chrome', label, artifactDirectory, scenarios: [], cleanupErrors: [],
  scope: 'Direct store operations in Dedicated Workers with real OPFS, IndexedDB, and Web Locks; no DSH Host or model',
  limitation: 'Same-origin browser fencing does not replace remote authorization, backend leases, or cross-device coordination',
}

async function workerMain(waitTimeout) {
  const { BrowserDurableWorkspaceStore, BrowserDownloadJournal } = await import('/store.js')
  const events = []
  let encoding
  let releaseEncoding
  let releaseHeldLock
  let pauseDownloadStage
  let sourceReadCount = 0
  let abortMetadata = false
  let legacyConnection
  let authorizationAllowed = true
  const emit = (type, details = {}) => {
    const event = { type, ...details }
    events.push(event)
    self.postMessage({ event })
  }
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
  const store = new BrowserDurableWorkspaceStore({
    abortNextMetadataTransaction: () => {
      const abort = abortMetadata
      abortMetadata = false
      return abort
    },
    quotaNextOpfsWrite: () => {
      if (encoding === undefined) return false
      encoding.quotaCalls += 1
      emit('quota-check', { count: encoding.quotaCalls, firstClosed: encoding.firstClosed })
      return encoding.quotaCalls === 2
    },
    downloadStage: async stage => {
      if (stage !== pauseDownloadStage) return
      emit(stage)
      await new Promise((resolveUnused, reject) => {
        setTimeout(() => reject(new Error(`Download pause at ${stage} timed out before Worker termination`)), waitTimeout)
      })
    },
  })
  const materialize = snapshot => {
    const change = item => typeof item.content === 'string'
      ? { ...item, content: new TextEncoder().encode(item.content) }
      : item
    return {
      ...snapshot,
      pending: snapshot.pending.map(change),
      ...(snapshot.retryBatch === undefined ? {} : { retryBatch: { ...snapshot.retryBatch, changes: snapshot.retryBatch.changes.map(change) } }),
    }
  }
  const record = async workspaceId => await new Promise((resolveRecord, reject) => {
    const opened = indexedDB.open('dsh-browser-native-workspace-v1')
    opened.onerror = () => reject(opened.error)
    opened.onsuccess = () => {
      const database = opened.result
      const transaction = database.transaction('workspace', 'readonly')
      const request = transaction.objectStore('workspace').get(workspaceId)
      transaction.oncomplete = () => { database.close(); resolveRecord(request.result ?? null) }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    }
  })
  const inspect = async workspaceId => {
    const files = []
    try {
      const root = await navigator.storage.getDirectory()
      const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${workspaceId}`)
      for await (const entry of directory.values()) {
        if (entry.kind !== 'file') continue
        const file = await entry.getFile()
        files.push({ name: entry.name, bytes: file.size, hash: await digest(await file.arrayBuffer()) })
      }
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error
    }
    return {
      record: await record(workspaceId), files,
      intents: await new BrowserDownloadJournal().list(workspaceId),
      events: events.slice(), sourceReadCount,
      encoding: encoding === undefined ? null : {
        quotaCalls: encoding.quotaCalls, firstClosed: encoding.firstClosed,
        activeWrites: encoding.activeWrites, saveSettled: encoding.saveSettled,
      },
    }
  }
  self.onmessage = async ({ data }) => {
    const { id, action, workspaceId } = data
    try {
      let value
      switch (action) {
        case 'deny-authorization': authorizationAllowed = false; value = true; break
        case 'acquire-authorized':
          emit('acquire-requested')
          await store.acquireWriter(workspaceId, async () => {
            emit('authorization-started')
            if (!authorizationAllowed) throw Object.assign(new Error('Remote writer was superseded'), { code: 'WORKSPACE_OWNERSHIP_LOST' })
            return () => {
              emit('authorization-rechecked')
              if (data.expireBeforeCommit === true) throw Object.assign(new Error('Remote authorization expired before local commit'), { code: 'WORKSPACE_OWNERSHIP_LOST' })
            }
          })
          value = true
          break
        case 'seed-legacy': {
          const content = new TextEncoder().encode('legacy pending and retry bytes')
          const hash = await digest(content)
          const root = await navigator.storage.getDirectory()
          const directory = await root.getDirectoryHandle(`dsh-workspace-blobs-${workspaceId}`, { create: true })
          const handle = await directory.getFileHandle(hash, { create: true })
          const writable = await handle.createWritable()
          await writable.write(content)
          await writable.close()
          const pending = { path: 'legacy.txt', kind: 'file', mode: 0o600, bytes: content.length, contentHash: hash }
          const snapshot = {
            version: 1, workspaceId, revision: 7, pending: [pending],
            retryBatch: { operationId: 'legacy-operation', baseRevision: 7, changes: [{ ...pending, path: 'retry.txt' }] },
            receipts: [{ operationId: 'legacy-receipt', workspaceId, baseRevision: 6, revision: 7,
              manifestDigest: 'legacy-manifest', paths: ['committed.txt'], replayed: false }],
          }
          await new Promise((resolveSeed, reject) => {
            const opened = indexedDB.open('dsh-browser-native-workspace-v1', 1)
            opened.onupgradeneeded = () => opened.result.createObjectStore('workspace', { keyPath: 'workspaceId' })
            opened.onerror = () => reject(opened.error)
            opened.onsuccess = () => {
              const database = opened.result
              const transaction = database.transaction('workspace', 'readwrite')
              transaction.objectStore('workspace').put(snapshot)
              transaction.oncomplete = () => {
                if (data.holdConnection === true) legacyConnection = database
                else database.close()
                resolveSeed()
              }
              transaction.onabort = () => { database.close(); reject(transaction.error) }
            }
          })
          value = { snapshot, hash, bytes: content.length }
          break
        }
        case 'close-legacy': legacyConnection?.close(); legacyConnection = undefined; value = true; break
        case 'read-legacy': {
          if (legacyConnection === undefined) throw new Error('No held legacy connection')
          value = await new Promise((resolveLegacy, reject) => {
            const transaction = legacyConnection.transaction('workspace', 'readonly')
            const request = transaction.objectStore('workspace').get(workspaceId)
            transaction.oncomplete = () => resolveLegacy(request.result)
            transaction.onabort = () => reject(transaction.error)
          })
          break
        }
        case 'metadata-state':
        case 'corrupt-control': {
          value = await new Promise((resolveState, reject) => {
            const opened = indexedDB.open('dsh-browser-native-workspace-v1')
            opened.onerror = () => reject(opened.error)
            opened.onsuccess = () => {
              const database = opened.result
              const stores = [...database.objectStoreNames]
              const transaction = database.transaction(stores, action === 'corrupt-control' ? 'readwrite' : 'readonly')
              const request = transaction.objectStore('control').get(workspaceId)
              request.onsuccess = () => {
                if (action === 'corrupt-control') transaction.objectStore('control').put({ ...request.result, generation: -1 })
              }
              transaction.oncomplete = () => {
                database.close()
                resolveState({ version: database.version, stores, control: request.result })
              }
              transaction.onabort = () => { database.close(); reject(transaction.error) }
            }
          })
          break
        }
        case 'acquire': await store.acquireWriter(workspaceId); value = true; break
        case 'assert-writer': await store.assertWriter(workspaceId); value = true; break
        case 'invalidate': store.invalidateWriter(workspaceId); value = true; break
        case 'clear': await store.clear(workspaceId); value = true; break
        case 'save':
          try {
            await store.save(materialize(data.snapshot))
            value = true
          } finally {
            if (encoding !== undefined) {
              encoding.saveSettled = true
              emit('save-settled')
            }
          }
          break
        case 'load': value = await store.load(workspaceId); break
        case 'list': value = await store.listWorkspaceIds(); break
        case 'inspect': value = await inspect(workspaceId); break
        case 'abort-metadata': abortMetadata = true; value = true; break
        case 'cache-local': {
          const content = new TextEncoder().encode(data.content)
          const hash = await digest(content)
          await store.cacheBlobFromRanges(workspaceId, hash, content.length, (offset, length) => content.slice(offset, offset + length))
          value = { hash, bytes: content.length }
          break
        }
        case 'open': {
          const backing = await store.openBlob(workspaceId, data.hash, data.bytes)
          value = backing === undefined ? null : Array.from(backing.read(0, backing.size))
          backing?.close()
          break
        }
        case 'open-digest': {
          const backing = await store.openBlob(workspaceId, data.hash, data.bytes)
          if (backing === undefined) throw new Error('Verified download backing is missing')
          try {
            value = { hash: await digest(backing.read(0, backing.size)), bytes: backing.size }
          } finally {
            backing.close()
          }
          break
        }
        case 'reconcile': value = await store.reconcileBlobs(workspaceId, []); break
        case 'hold':
          await navigator.locks.request(`dsh-workspace-local-${workspaceId}`, { mode: 'exclusive' }, async () => {
            emit('lock-held')
            await new Promise(resolveHeld => { releaseHeldLock = resolveHeld })
          })
          value = true
          break
        case 'release-lock': releaseHeldLock?.(); value = true; break
        case 'release-encoding': releaseEncoding?.(); value = true; break
        case 'arm-encoding': {
          const firstHash = await digest(new TextEncoder().encode(data.firstContent))
          const secondHash = await digest(new TextEncoder().encode(data.secondContent))
          encoding = { quotaCalls: 0, firstClosed: false, activeWrites: 0, saveSettled: false }
          const originalCreate = FileSystemFileHandle.prototype.createWritable
          const originalGet = FileSystemDirectoryHandle.prototype.getFileHandle
          let firstPaused
          const paused = new Promise(resolvePaused => { firstPaused = resolvePaused })
          FileSystemDirectoryHandle.prototype.getFileHandle = async function (name, options) {
            if (name === secondHash && options?.create === true) await paused
            return await originalGet.call(this, name, options)
          }
          FileSystemFileHandle.prototype.createWritable = async function (...args) {
            const first = this.name === firstHash
            if (first) {
              encoding.activeWrites += 1
              emit('first-paused')
              firstPaused()
              await new Promise(resolveEncoding => { releaseEncoding = resolveEncoding })
            }
            const writable = await originalCreate.apply(this, args)
            const originalWrite = writable.write.bind(writable)
            const originalClose = writable.close.bind(writable)
            writable.write = async command => {
              await originalWrite(command)
              emit('write-complete', { afterSaveSettled: encoding.saveSettled })
            }
            writable.close = async () => {
              await originalClose()
              if (first) {
                encoding.firstClosed = true
                encoding.activeWrites -= 1
              }
              emit('close-complete', { first, afterSaveSettled: encoding.saveSettled })
            }
            return writable
          }
          value = true
          break
        }
        case 'pause-download': {
          const stage = data.stage ?? 'intent-durable'
          if (!['intent-durable', 'entry-created', 'first-chunk-written', 'published'].includes(stage)) {
            throw new Error(`Invalid download pause stage ${stage}`)
          }
          pauseDownloadStage = stage
          value = true
          break
        }
        case 'download': {
          const content = new TextEncoder().encode(data.content)
          const hash = await digest(content)
          emit('download-requested')
          const published = await store.cacheBlobFromChunks(workspaceId, hash, content.length,
            async (offset, length) => {
              sourceReadCount += 1
              emit('download-source-read', { sourceReadCount, offset, length })
              return content.slice(offset, offset + length)
            })
          value = { published, sourceReadCount, hash, bytes: content.length }
          break
        }
        case 'delete-metadata':
          await navigator.locks.request(`dsh-workspace-local-${workspaceId}`, { mode: 'exclusive' }, async () => {
            await new Promise((resolveDelete, reject) => {
              const opened = indexedDB.open('dsh-browser-native-workspace-v1')
              opened.onerror = () => reject(opened.error)
              opened.onsuccess = () => {
                const database = opened.result
                const transaction = database.transaction('workspace', 'readwrite')
                transaction.objectStore('workspace').delete(workspaceId)
                transaction.oncomplete = () => { database.close(); resolveDelete() }
                transaction.onabort = () => { database.close(); reject(transaction.error) }
              }
            })
          })
          value = true
          break
        default: throw new Error(`Unknown action ${action}`)
      }
      self.postMessage({ id, ok: true, value })
    } catch (error) {
      self.postMessage({ id, ok: false, error: { name: error.name, message: error.message, code: error.code } })
    }
  }
  self.postMessage({ ready: true })
}

async function installClients(page) {
  await page.evaluate(() => {
    const clients = new Map()
    window.storeConcurrency = {
      clients,
      create: async name => {
        const worker = new Worker('/worker.js', { type: 'module', name })
        const client = { worker, events: [], requests: new Map(), results: new Map(), sequence: 0 }
        clients.set(name, client)
        await new Promise((resolveReady, reject) => {
          worker.onerror = event => reject(new Error(event.message))
          worker.onmessage = ({ data }) => {
            if (data.ready) resolveReady()
            else if (data.event) client.events.push(data.event)
            else {
              client.requests.get(data.id)?.(data)
              client.requests.delete(data.id)
            }
          }
        })
      },
      start: (name, action, fields) => {
        const client = clients.get(name)
        const id = ++client.sequence
        client.results.set(id, new Promise(resolveResult => { client.requests.set(id, resolveResult) }))
        client.worker.postMessage({ id, action, ...fields })
        return id
      },
    }
  })
}

async function start(page, name, action, fields = {}) {
  return await page.evaluate(({ name, action, fields }) => window.storeConcurrency.start(name, action, fields), { name, action, fields })
}

async function result(page, name, id) {
  let timer
  try {
    return await Promise.race([
      page.evaluate(async ({ name, id }) => await window.storeConcurrency.clients.get(name).results.get(id), { name, id }),
      new Promise((resolveUnused, reject) => {
        timer = setTimeout(() => reject(new Error(`Worker ${name} request ${id} timed out`)), timeout)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function request(page, name, action, fields = {}) {
  return await result(page, name, await start(page, name, action, fields))
}

async function success(page, name, action, fields = {}) {
  const response = await request(page, name, action, fields)
  assert.equal(response.ok, true, JSON.stringify(response))
  return response.value
}

async function event(page, name, type) {
  await page.waitForFunction(({ name, type }) => window.storeConcurrency.clients.get(name).events.some(item => item.type === type), { name, type }, { timeout })
}

const clean = workspaceId => ({ version: 1, workspaceId, revision: 0, pending: [] })
const change = (path, content) => ({ path, kind: 'file', mode: 0o600, bytes: Buffer.byteLength(content), content })
const scenarios = {
  'queued-acquire-reauthorizes': async (page, observation) => {
    const workspaceId = randomUUID()
    await success(page, 'first', 'acquire', { workspaceId })
    await success(page, 'first', 'load', { workspaceId })
    await success(page, 'first', 'save', { snapshot: { ...clean(workspaceId), pending: [change('successor.txt', 'legitimate new owner')] } })
    observation.before = await success(page, 'first', 'inspect', { workspaceId })
    observation.controlBefore = await success(page, 'first', 'metadata-state', { workspaceId })
    const holding = await start(page, 'first', 'hold', { workspaceId })
    await event(page, 'first', 'lock-held')
    const acquiring = await start(page, 'second', 'acquire-authorized', { workspaceId })
    await event(page, 'second', 'acquire-requested')
    await page.waitForFunction(async id => (await navigator.locks.query()).pending.some(lock => lock.name === `dsh-workspace-local-${id}`), workspaceId, { timeout })
    observation.overlap = await page.evaluate(async () => ({ locks: await navigator.locks.query(), events: window.storeConcurrency.clients.get('second').events.slice() }))
    assert.equal(observation.overlap.events.some(item => item.type === 'authorization-started'), false, 'Authorization must run inside the acquired lock')
    await success(page, 'second', 'deny-authorization')
    await success(page, 'first', 'release-lock')
    await result(page, 'first', holding)
    observation.acquired = await result(page, 'second', acquiring)
    assert.equal(observation.acquired.error?.code, 'WORKSPACE_OWNERSHIP_LOST')
    observation.after = await success(page, 'first', 'inspect', { workspaceId })
    observation.controlAfter = await success(page, 'first', 'metadata-state', { workspaceId })
    assert.deepEqual(observation.after.record, observation.before.record)
    assert.deepEqual(observation.after.files, observation.before.files)
    assert.deepEqual(observation.controlAfter, observation.controlBefore)
    await success(page, 'first', 'assert-writer', { workspaceId })
  },
  'authorization-recheck-before-commit': async (page, observation) => {
    const workspaceId = randomUUID()
    await success(page, 'first', 'acquire', { workspaceId })
    await success(page, 'first', 'load', { workspaceId })
    await success(page, 'first', 'save', { snapshot: clean(workspaceId) })
    observation.before = await success(page, 'first', 'metadata-state', { workspaceId })
    observation.acquired = await request(page, 'second', 'acquire-authorized', { workspaceId, expireBeforeCommit: true })
    assert.equal(observation.acquired.error?.code, 'WORKSPACE_OWNERSHIP_LOST')
    observation.after = await success(page, 'first', 'metadata-state', { workspaceId })
    assert.deepEqual(observation.after, observation.before)
    await success(page, 'first', 'assert-writer', { workspaceId })
  },
  'legacy-migration-preserves-outbox': async (page, observation) => {
    const workspaceId = randomUUID()
    observation.legacy = await success(page, 'first', 'seed-legacy', { workspaceId })
    await success(page, 'second', 'acquire', { workspaceId })
    observation.loaded = await success(page, 'second', 'load', { workspaceId })
    assert.equal(observation.loaded.revision, 7)
    assert.equal(observation.loaded.pending[0].path, 'legacy.txt')
    assert.equal(observation.loaded.retryBatch.operationId, 'legacy-operation')
    assert.deepEqual(observation.loaded.receipts, observation.legacy.snapshot.receipts)
    observation.metadata = await success(page, 'second', 'metadata-state', { workspaceId })
    assert.equal(observation.metadata.version, 2)
    assert.equal(observation.metadata.control.writerEpoch, 1)
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.deepEqual(observation.after.record, observation.legacy.snapshot, 'Migration must not rewrite the existing snapshot')
    assert.deepEqual(observation.after.files, [{ name: observation.legacy.hash, hash: observation.legacy.hash, bytes: observation.legacy.bytes }])
  },
  'blocked-upgrade-retains-legacy': async (page, observation) => {
    const workspaceId = randomUUID()
    observation.legacy = await success(page, 'first', 'seed-legacy', { workspaceId, holdConnection: true })
    observation.blocked = await request(page, 'second', 'acquire', { workspaceId })
    assert.equal(observation.blocked.ok, false)
    assert.match(observation.blocked.error?.message ?? '', /blocked/i)
    observation.afterFailure = await success(page, 'first', 'read-legacy', { workspaceId })
    assert.deepEqual(observation.afterFailure, observation.legacy.snapshot)
    await success(page, 'first', 'close-legacy')
    await success(page, 'first', 'acquire', { workspaceId })
    observation.loaded = await success(page, 'first', 'load', { workspaceId })
    assert.equal(observation.loaded.retryBatch.operationId, 'legacy-operation')
  },
  'corrupt-control-retains-bytes': async (page, observation) => {
    const workspaceId = randomUUID()
    await success(page, 'first', 'save', { snapshot: { ...clean(workspaceId), pending: [change('keep.txt', 'local only bytes')] } })
    observation.before = await success(page, 'first', 'inspect', { workspaceId })
    await success(page, 'first', 'corrupt-control', { workspaceId })
    observation.load = await request(page, 'second', 'load', { workspaceId })
    assert.equal(observation.load.error?.code, 'LOCAL_CONTROL_INVALID')
    observation.after = await success(page, 'first', 'inspect', { workspaceId })
    assert.deepEqual(observation.after.record, observation.before.record)
    assert.deepEqual(observation.after.files, observation.before.files)
  },
  'identical-record-aba': async (page, observation) => {
    const workspaceId = randomUUID()
    const initial = clean(workspaceId)
    await success(page, 'first', 'save', { snapshot: initial })
    await success(page, 'second', 'load', { workspaceId })
    await success(page, 'second', 'save', { snapshot: { ...initial, pending: [change('intermediate.txt', 'intervening edit')] } })
    await success(page, 'second', 'save', { snapshot: initial })
    observation.stale = await request(page, 'first', 'save', { snapshot: { ...initial, pending: [change('stale.txt', 'stale write')] } })
    assert.equal(observation.stale.error?.code, 'LOCAL_SNAPSHOT_CONFLICT')
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.deepEqual(observation.after.record, initial)
  },
  'clear-recreate-aba': async (page, observation) => {
    const workspaceId = randomUUID()
    const initial = clean(workspaceId)
    await success(page, 'first', 'save', { snapshot: initial })
    await success(page, 'second', 'load', { workspaceId })
    await success(page, 'second', 'clear', { workspaceId })
    await success(page, 'second', 'save', { snapshot: initial })
    observation.stale = await request(page, 'first', 'save', { snapshot: { ...initial, pending: [change('stale.txt', 'stale after clear')] } })
    assert.equal(observation.stale.error?.code, 'LOCAL_SNAPSHOT_CONFLICT')
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.deepEqual(observation.after.record, initial)
  },
  'local-owner-fencing': async (page, observation) => {
    const workspaceId = randomUUID()
    const initial = clean(workspaceId)
    await success(page, 'first', 'acquire', { workspaceId })
    await success(page, 'first', 'load', { workspaceId })
    await success(page, 'first', 'save', { snapshot: initial })
    await success(page, 'second', 'acquire', { workspaceId })
    await success(page, 'second', 'load', { workspaceId })
    await success(page, 'second', 'save', { snapshot: {
      ...initial, pending: [change('successor.txt', 'successor pending')],
      retryBatch: { operationId: randomUUID(), baseRevision: 0, changes: [change('retry.txt', 'successor retry')] },
    } })
    observation.before = await success(page, 'second', 'inspect', { workspaceId })
    observation.rejected = []
    for (const [action, fields] of [
      ['load', {}], ['save', { snapshot: initial }], ['cache-local', { content: 'late local bytes' }],
      ['reconcile', {}], ['clear', {}], ['assert-writer', {}],
    ]) {
      const response = await request(page, 'first', action, { workspaceId, ...fields })
      observation.rejected.push({ action, response })
      assert.equal(response.ok, false, `Old writer must reject ${action}`)
      assert.match(response.error?.code ?? '', /LOCAL_.*(WRITER|OWNERSHIP)/)
    }
    await success(page, 'first', 'invalidate', { workspaceId })
    await success(page, 'second', 'assert-writer', { workspaceId })
    observation.reacquire = await request(page, 'first', 'acquire', { workspaceId })
    assert.equal(observation.reacquire.ok, false, 'An invalidated store must not silently acquire a new identity')
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.deepEqual(observation.after.record, observation.before.record)
    assert.deepEqual(observation.after.files, observation.before.files)
  },
  'stale-snapshot': async (page, observation) => {
    const workspaceId = randomUUID()
    const initial = clean(workspaceId)
    await success(page, 'first', 'save', { snapshot: initial })
    await success(page, 'second', 'load', { workspaceId })
    const successor = {
      ...initial, pending: [change('successor.txt', 'new successor pending')],
      retryBatch: { operationId: randomUUID(), baseRevision: 0, changes: [change('retry.txt', 'durable retry')] },
    }
    await success(page, 'second', 'save', { snapshot: successor })
    observation.before = await success(page, 'second', 'inspect', { workspaceId })
    observation.staleSave = await request(page, 'first', 'save', { snapshot: initial })
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.equal(observation.staleSave.error?.code, 'LOCAL_SNAPSHOT_CONFLICT')
    assert.deepEqual(observation.after.record, observation.before.record)
    assert.deepEqual(observation.after.files, observation.before.files)
  },
  'unobserved-existing-snapshot': async (page, observation) => {
    const workspaceId = randomUUID()
    const snapshot = { ...clean(workspaceId), pending: [change('existing.txt', 'keep existing pending')] }
    await success(page, 'first', 'save', { snapshot })
    observation.before = await success(page, 'first', 'inspect', { workspaceId })
    observation.save = await request(page, 'second', 'save', { snapshot: clean(workspaceId) })
    observation.after = await success(page, 'first', 'inspect', { workspaceId })
    assert.equal(observation.save.error?.code, 'LOCAL_SNAPSHOT_CONFLICT')
    assert.deepEqual(observation.after.record, observation.before.record)
  },
  'reference-collected-before-save': async (page, observation) => {
    const workspaceId = randomUUID()
    const snapshot = clean(workspaceId)
    const content = 'unique draft not uploaded'
    await success(page, 'first', 'save', { snapshot })
    await success(page, 'second', 'load', { workspaceId })
    const reference = await success(page, 'first', 'cache-local', { workspaceId, content })
    observation.gc = await success(page, 'second', 'reconcile', { workspaceId })
    const pending = { ...snapshot, pending: [{ path: 'draft.txt', kind: 'file', mode: 0o600, bytes: reference.bytes, contentReference: reference }] }
    observation.save = await request(page, 'first', 'save', { snapshot: pending })
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.equal(observation.gc.removedFiles, 1)
    assert.equal(observation.save.error?.code, 'LOCAL_BLOB_MISSING')
    assert.deepEqual(observation.after.record, snapshot)
    await success(page, 'first', 'cache-local', { workspaceId, content })
    await success(page, 'first', 'save', { snapshot: pending })
    observation.repairedBytes = await success(page, 'second', 'open', { workspaceId, ...reference })
    assert.deepEqual(observation.repairedBytes, [...Buffer.from(content)])
  },
  'failed-transaction-observation': async (page, observation) => {
    const workspaceId = randomUUID()
    const initial = clean(workspaceId)
    await success(page, 'first', 'save', { snapshot: initial })
    observation.metadataBefore = await success(page, 'first', 'metadata-state', { workspaceId })
    await success(page, 'first', 'abort-metadata')
    observation.aborted = await request(page, 'first', 'save', { snapshot: { ...initial, pending: [change('abort.txt', 'aborted snapshot')] } })
    observation.afterAbort = await success(page, 'second', 'inspect', { workspaceId })
    assert.equal(observation.aborted.ok, false)
    assert.deepEqual(observation.afterAbort.record, initial)
    observation.metadataAfterAbort = await success(page, 'first', 'metadata-state', { workspaceId })
    assert.deepEqual(observation.metadataAfterAbort, observation.metadataBefore, 'An aborted snapshot must not advance the committed generation')
    const next = { ...initial, pending: [change('next.txt', 'next snapshot')] }
    observation.next = await request(page, 'first', 'save', { snapshot: next })
    observation.afterNext = await success(page, 'second', 'inspect', { workspaceId })
    assert.equal(observation.next.ok, true)
    assert.equal(observation.afterNext.record.pending[0].path, 'next.txt')
    observation.metadataAfterNext = await success(page, 'first', 'metadata-state', { workspaceId })
    assert.equal(observation.metadataAfterNext.control.generation, observation.metadataBefore.control.generation + 1)
  },
  'journal-only-enumeration': async (page, observation) => {
    const workspaceId = randomUUID()
    await success(page, 'first', 'save', { snapshot: clean(workspaceId) })
    await success(page, 'first', 'pause-download')
    await start(page, 'first', 'download', { workspaceId, content: 'download never created its canonical entry' })
    await event(page, 'first', 'intent-durable')
    await page.evaluate(() => window.storeConcurrency.clients.get('first').worker.terminate())
    await success(page, 'second', 'delete-metadata', { workspaceId })
    observation.before = await success(page, 'second', 'inspect', { workspaceId })
    observation.workspaceIds = await success(page, 'second', 'list')
    observation.load = await request(page, 'second', 'load', { workspaceId })
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.equal(observation.before.record, null)
    assert.deepEqual(observation.before.files, [])
    assert.equal(observation.before.intents.length, 1)
    assert.deepEqual(observation.workspaceIds, [workspaceId])
    assert.equal(observation.load.error?.code, 'LOCAL_METADATA_MISSING')
    assert.deepEqual(observation.after.intents, observation.before.intents)
  },
}

for (const owner of ['pending', 'retry']) {
  scenarios[`serial-encoding-${owner}`] = async (page, observation) => {
    const workspaceId = randomUUID()
    const initial = clean(workspaceId)
    const firstContent = `first ${owner} write paused before creating its writable`
    const secondContent = `second ${owner} write must wait for the first close`
    const changes = [change('first.txt', firstContent), change('second.txt', secondContent)]
    const snapshot = owner === 'pending' ? { ...initial, pending: changes }
      : { ...initial, retryBatch: { operationId: randomUUID(), baseRevision: 0, changes } }
    await success(page, 'first', 'save', { snapshot: initial })
    await success(page, 'second', 'load', { workspaceId })
    await success(page, 'first', 'arm-encoding', { firstContent, secondContent })
    const saving = await start(page, 'first', 'save', { snapshot })
    await event(page, 'first', 'first-paused')
    const holding = await start(page, 'second', 'hold', { workspaceId })
    let completed = false
    try {
      await page.waitForFunction(async workspaceId => {
        const locks = await navigator.locks.query()
        const name = `dsh-workspace-local-${workspaceId}`
        return locks.pending.some(lock => lock.name === name)
          || window.storeConcurrency.clients.get('second').events.some(item => item.type === 'lock-held')
      }, workspaceId, { timeout })
      observation.duringBarrier = await page.evaluate(async () => ({
        locks: await navigator.locks.query(),
        firstEvents: window.storeConcurrency.clients.get('first').events.slice(),
        secondEvents: window.storeConcurrency.clients.get('second').events.slice(),
      }))
      await success(page, 'first', 'release-encoding')
      observation.save = await result(page, 'first', saving)
      await event(page, 'first', 'close-complete')
      await event(page, 'second', 'lock-held')
      observation.afterFailure = await success(page, 'first', 'inspect', { workspaceId })
      await success(page, 'second', 'release-lock')
      await result(page, 'second', holding)
      completed = true
      observation.afterDrain = await success(page, 'first', 'inspect', { workspaceId })
    } finally {
      if (!completed) {
        await request(page, 'first', 'release-encoding')
        await request(page, 'second', 'release-lock')
      }
    }
    const lockName = `dsh-workspace-local-${workspaceId}`
    assert.ok(observation.duringBarrier.locks.pending.some(lock => lock.name === lockName), 'Worker B must still be waiting while the first encode is paused')
    assert.equal(observation.duringBarrier.secondEvents.some(item => item.type === 'lock-held'), false)
    assert.equal(observation.duringBarrier.firstEvents.filter(item => item.type === 'quota-check').length, 1)
    assert.equal(observation.save.error?.name, 'QuotaExceededError')
    const events = observation.afterFailure.events
    const closed = events.findIndex(item => item.type === 'close-complete' && item.first)
    const quota = events.findIndex(item => item.type === 'quota-check' && item.count === 2)
    const settled = events.findIndex(item => item.type === 'save-settled')
    assert.ok(closed >= 0 && quota > closed && settled > quota, 'First close must settle before the second quota failure and save rejection')
    assert.equal(events[quota].firstClosed, true)
    assert.equal(events.some(item => item.afterSaveSettled === true), false)
    assert.equal(observation.afterFailure.encoding.activeWrites, 0)
    assert.deepEqual(observation.afterFailure.record, initial)
    assert.deepEqual(observation.afterDrain, observation.afterFailure)
  }
}

for (const stage of ['entry-created', 'published']) {
  scenarios[`terminated-download-${stage}`] = async (page, observation) => {
    const startedAt = performance.now()
    const workspaceId = randomUUID()
    const snapshot = clean(workspaceId)
    const content = `competing download at ${stage}\n`.repeat(4096)
    const expected = { hash: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }
    const lockName = `dsh-workspace-local-${workspaceId}`
    observation.stage = stage
    observation.expected = expected
    await success(page, 'first', 'save', { snapshot })
    await success(page, 'first', 'pause-download', { stage })
    await start(page, 'first', 'download', { workspaceId, content })
    await event(page, 'first', stage)
    observation.beforeTermination = await success(page, 'second', 'inspect', { workspaceId })
    assert.equal(observation.beforeTermination.intents.length, 1)
    assert.equal(observation.beforeTermination.files.length, 1)
    assert.equal(observation.beforeTermination.files[0].name, expected.hash)
    assert.equal(observation.beforeTermination.files[0].bytes, stage === 'published' ? expected.bytes : 0)
    if (stage === 'published') assert.equal(observation.beforeTermination.files[0].hash, expected.hash)
    const waiting = await start(page, 'second', 'download', { workspaceId, content })
    await event(page, 'second', 'download-requested')
    await page.waitForFunction(async name => {
      const locks = await navigator.locks.query()
      return locks.held.some(lock => lock.name === name) && locks.pending.some(lock => lock.name === name)
    }, lockName, { timeout })
    observation.overlap = await page.evaluate(async ({ lockName, waiting }) => {
      const locks = await navigator.locks.query()
      return {
        held: locks.held.filter(lock => lock.name === lockName),
        pending: locks.pending.filter(lock => lock.name === lockName),
        secondRequestPending: window.storeConcurrency.clients.get('second').requests.has(waiting),
        firstEvents: window.storeConcurrency.clients.get('first').events.slice(),
        secondEvents: window.storeConcurrency.clients.get('second').events.slice(),
      }
    }, { lockName, waiting })
    assert.equal(observation.overlap.held.length, 1)
    assert.equal(observation.overlap.pending.length, 1)
    assert.notEqual(observation.overlap.held[0].clientId, observation.overlap.pending[0].clientId)
    assert.equal(observation.overlap.secondRequestPending, true)
    assert.equal(observation.overlap.secondEvents.some(item => item.type === 'download-source-read'), false)
    await page.evaluate(() => window.storeConcurrency.clients.get('first').worker.terminate())
    observation.firstTerminated = true
    observation.download = await result(page, 'second', waiting)
    assert.equal(observation.download.ok, true, JSON.stringify(observation.download))
    assert.equal(observation.download.value.published, true)
    observation.sourceReads = observation.download.value.sourceReadCount
    if (stage === 'published') assert.equal(observation.sourceReads, 0)
    else assert.ok(observation.sourceReads > 0, 'The waiter must read the source after recovering an empty entry')
    observation.opened = await success(page, 'second', 'open-digest', { workspaceId, ...expected })
    assert.deepEqual(observation.opened, expected)
    observation.after = await success(page, 'second', 'inspect', { workspaceId })
    assert.deepEqual(observation.after.record, snapshot)
    assert.deepEqual(observation.after.intents, [])
    assert.deepEqual(observation.after.files, [{ name: expected.hash, ...expected }])
    await page.waitForFunction(async name => {
      const locks = await navigator.locks.query()
      return ![...locks.held, ...locks.pending].some(lock => lock.name === name)
    }, lockName, { timeout })
    observation.finalLocks = await page.evaluate(async () => await navigator.locks.query())
    assert.deepEqual(observation.finalLocks.held, [])
    assert.deepEqual(observation.finalLocks.pending, [])
    observation.elapsedMs = Math.round(performance.now() - startedAt)
  }
}

let browser
let server
try {
  let moduleBytes
  if (process.env.DSH_POC_STORE_CONCURRENCY_BUNDLE !== undefined) {
    evidence.bundleInput = resolve(process.env.DSH_POC_STORE_CONCURRENCY_BUNDLE)
    moduleBytes = await readFile(evidence.bundleInput)
  } else {
    const esbuild = createRequire(require.resolve('tsx'))('esbuild')
    const built = await esbuild.build({
      stdin: {
        contents: 'export { BrowserDurableWorkspaceStore } from "./browser-native-workspace-store.ts"; export { BrowserDownloadJournal } from "./browser-native-download-journal.ts";',
        resolveDir: sourceDirectory, sourcefile: 'store-concurrency-entry.ts', loader: 'ts',
      },
      bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false, sourcemap: 'inline',
    })
    moduleBytes = built.outputFiles[0].contents
    const captureDirectory = join(artifactDirectory, `${label}-sources`)
    await mkdir(captureDirectory, { recursive: true })
    evidence.sources = {}
    for (const filename of sourceFiles) {
      const source = await readFile(join(sourceDirectory, filename))
      await writeFile(join(captureDirectory, filename), source)
      evidence.sources[filename] = createHash('sha256').update(source).digest('hex')
    }
  }
  evidence.bundleSha256 = createHash('sha256').update(moduleBytes).digest('hex')
  await writeFile(join(artifactDirectory, `${label}-store-bundle.js`), moduleBytes)
  const workerSource = `(${workerMain.toString()})(${timeout}).catch(error => { throw error })\n`
  await writeFile(join(artifactDirectory, `${label}-worker.js`), workerSource)
  server = createServer((incoming, response) => {
    const routes = new Map([
      ['/', ['text/html', '<!doctype html><title>Store concurrency validation</title>']],
      ['/worker.js', ['text/javascript', workerSource]],
      ['/store.js', ['text/javascript', moduleBytes]],
    ])
    const route = routes.get(incoming.url)
    response.writeHead(route === undefined ? 404 : 200, { 'content-type': route?.[0] ?? 'text/plain' })
    response.end(route?.[1] ?? 'Not found')
  })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ headless: true, channel: 'chrome' })
  evidence.browserVersion = browser.version()
  for (const [name, run] of Object.entries(scenarios)) {
    if (selectedScenarios !== undefined && !selectedScenarios.includes(name)) continue
    const observation = { name, result: 'running' }
    evidence.scenarios.push(observation)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(timeout)
      await page.goto(origin, { waitUntil: 'domcontentloaded' })
      await installClients(page)
      for (const workerName of ['first', 'second']) {
        await page.evaluate(async name => await window.storeConcurrency.create(name), workerName)
      }
      await run(page, observation)
      observation.result = 'passed'
    } catch (error) {
      observation.result = 'failed'
      observation.error = { name: error.name, message: error.message, stack: error.stack }
    } finally {
      await context.close()
      await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
    }
    process.stdout.write(`${label}: ${name}: ${observation.result}\n`)
  }
  assert.ok(evidence.scenarios.length > 0, 'At least one scenario must run')
  if (selectedScenarios !== undefined) assert.deepEqual(evidence.scenarios.map(item => item.name).sort(), [...selectedScenarios].sort())
  evidence.result = evidence.scenarios.every(scenario => scenario.result === 'passed') ? 'passed' : 'failed'
} catch (error) {
  evidence.result = 'failed'
  evidence.error = { name: error.name, message: error.message, stack: error.stack }
} finally {
  for (const [name, close] of [
    ['browser', async () => await browser?.close()],
    ['server', async () => { if (server?.listening) await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())) }],
  ]) {
    try { await close() } catch (error) { evidence.cleanupErrors.push({ name, message: error.message }) }
  }
  if (evidence.cleanupErrors.length > 0) evidence.result = 'failed'
  await mkdir(dirname(resultFile), { recursive: true })
  await writeFile(resultFile, `${JSON.stringify(evidence, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({ result: evidence.result, resultFile, scenarios: evidence.scenarios.map(({ name, result }) => ({ name, result })) })}\n`)
}
if (evidence.result !== 'passed') process.exitCode = 1
