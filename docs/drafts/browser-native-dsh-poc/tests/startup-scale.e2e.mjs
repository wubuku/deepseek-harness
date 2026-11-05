/**
 * Cold-start scale measurement for the browser-native backend.
 *
 * Seeds a data directory with N Session records, several Workspaces with
 * content-addressed attachments, and a full audit ledger, then measures
 * `FormalSessionStore.load()` time and heap, whole-server cold start, and the
 * first durable turn. Budgets come from the "启动恢复退化" trigger in
 * multi-instance-feasibility.md and can be overridden:
 *
 *   node --expose-gc docs/drafts/browser-native-dsh-poc/tests/startup-scale.e2e.mjs
 *
 * Env overrides: DSH_POC_STARTUP_SIZES, DSH_POC_STARTUP_EVENTS,
 * DSH_POC_STARTUP_WORKSPACES, DSH_POC_STARTUP_AUDIT, and the four *_BUDGET_*.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { after, test } from 'node:test'
import { createBrowserNativeV2Server, FormalSessionStore } from '../backend-v2.mjs'
import { createObservabilityJournal } from '../observability-journal.mjs'

const EVENTS_PER_SESSION = Number(process.env.DSH_POC_STARTUP_EVENTS ?? 50)
const WORKSPACES = Number(process.env.DSH_POC_STARTUP_WORKSPACES ?? 4)
const AUDIT_ENTRIES = Number(process.env.DSH_POC_STARTUP_AUDIT ?? 1_000)
const ATTACHMENTS_PER_WORKSPACE = 3
const SIZES = (process.env.DSH_POC_STARTUP_SIZES ?? '0,250,1000').split(',').map(Number).sort((a, b) => a - b)
const LARGEST = SIZES.at(-1)
const MiB = 1024 * 1024

const LOAD_BUDGET_MS = Number(process.env.DSH_POC_STARTUP_LOAD_BUDGET_MS ?? 5_000)
const COLD_BUDGET_MS = Number(process.env.DSH_POC_STARTUP_COLD_BUDGET_MS ?? 10_000)
const HEAP_BUDGET_BYTES = Number(process.env.DSH_POC_STARTUP_HEAP_BUDGET_BYTES ?? 256 * MiB)
const TURN_BUDGET_MS = Number(process.env.DSH_POC_STARTUP_TURN_BUDGET_MS ?? 2_000)

for (const [name, value] of Object.entries({
  DSH_POC_STARTUP_EVENTS: EVENTS_PER_SESSION,
  DSH_POC_STARTUP_WORKSPACES: WORKSPACES,
  DSH_POC_STARTUP_AUDIT: AUDIT_ENTRIES,
  DSH_POC_STARTUP_LOAD_BUDGET_MS: LOAD_BUDGET_MS,
  DSH_POC_STARTUP_COLD_BUDGET_MS: COLD_BUDGET_MS,
  DSH_POC_STARTUP_HEAP_BUDGET_BYTES: HEAP_BUDGET_BYTES,
  DSH_POC_STARTUP_TURN_BUDGET_MS: TURN_BUDGET_MS,
})) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
}

const directories = []
const remember = async path => {
  const directory = await mkdtemp(join(tmpdir(), path))
  directories.push(directory)
  return directory
}

after(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

async function collectGarbage() {
  globalThis.gc?.()
  await new Promise(resolve => setTimeout(resolve, 20))
  globalThis.gc?.()
}

async function identity(origin) {
  const response = await fetch(`${origin}/api/browser-native/workspace/identity`)
  assert.equal(response.status, 200)
  const cookies = response.headers.getSetCookie().map(value => value.split(';')[0])
  const body = await response.json()
  return { cookie: cookies.join('; '), workspaceId: body.workspaceId }
}

/** Seed Workspaces, attachments, and the audit ledger once; Sessions are added per size. */
async function seedInfrastructure(base) {
  await mkdir(base, { recursive: true })
  const app = await createBrowserNativeV2Server({ dataDir: base, port: 0, llmMode: 'scripted', durableTurnTimeoutMs: 120_000 })
  const origin = await app.listen()
  try {
    const owners = []
    for (let index = 0; index < WORKSPACES; index += 1) owners.push(await identity(origin))
    for (const [ownerIndex, owner] of owners.entries()) {
      for (let attachment = 0; attachment < ATTACHMENTS_PER_WORKSPACE; attachment += 1) {
        const bytes = Buffer.from(`workspace ${String(ownerIndex)} attachment ${String(attachment)} `.repeat(32))
        const hash = createHash('sha256').update(bytes).digest('hex')
        const response = await fetch(`${origin}/api/browser-native/workspace/attachments/${hash}?workspaceId=${owner.workspaceId}&name=${String(attachment)}.txt`, {
          method: 'PUT',
          headers: { cookie: owner.cookie, 'content-type': 'application/octet-stream' },
          body: bytes,
        })
        assert.equal(response.status, 200)
      }
    }
  } finally {
    await app.close()
  }
  const journal = createObservabilityJournal({ dataDir: base })
  for (let index = 0; index < AUDIT_ENTRIES; index += 1) {
    await journal.appendAccessDenial({
      at: 1_700_000_000_000 + index,
      route: '/api/browser-native/session/read',
      reason: 'principal-mismatch',
      sessionId: `audit-${String(index)}`,
    })
  }
}

function sessionRecord(index) {
  const id = `scale-${String(index).padStart(4, '0')}`
  const events = Array.from({ length: EVENTS_PER_SESSION }, (_, seq) => ({
    seq,
    type: seq % 2 === 0 ? 'user/message' : 'assistant/message',
    data: { content: `session ${id} event ${String(seq)} ${'x'.repeat(120)}` },
    at: '2026-11-05T00:00:00.000Z',
  }))
  return {
    id,
    header: { id, version: 4, createdAt: 1_700_000_000_000, cwd: '/workspace' },
    inheritedEventCount: 0,
    events,
    durableThroughSeq: events.length - 1,
    ownerEpoch: 0,
    handoffs: {},
  }
}

async function writeSessions(dataDir, count) {
  await mkdir(join(dataDir, 'sessions'), { recursive: true })
  for (let start = 0; start < count; start += 100) {
    const batch = []
    for (let index = start; index < Math.min(start + 100, count); index += 1) {
      batch.push(writeFile(join(dataDir, 'sessions', `scale-${String(index).padStart(4, '0')}.json`), `${JSON.stringify(sessionRecord(index))}\n`))
    }
    await Promise.all(batch)
  }
}

async function measureStoreLoad(dataDir) {
  await collectGarbage()
  const before = process.memoryUsage().heapUsed
  const store = new FormalSessionStore(dataDir)
  const started = performance.now()
  await store.load()
  const loadMs = performance.now() - started
  await collectGarbage()
  const heapDelta = process.memoryUsage().heapUsed - before
  const loaded = store.sessions.size
  store.sessions.clear()
  return { loadMs, heapDelta, loaded }
}

async function measureStartup(dataDir, size) {
  await collectGarbage()
  const coldStart = performance.now()
  const app = await createBrowserNativeV2Server({
    dataDir,
    port: 0,
    llmMode: 'scripted',
    durableTurnTimeoutMs: 120_000,
    testHooks: { scriptedLlmFault: () => ({ kind: 'text', text: 'SCALE_TURN_DONE' }) },
  })
  const origin = await app.listen()
  const coldMs = performance.now() - coldStart
  try {
    const owner = await identity(origin)
    const turnId = `scale-turn-${String(size)}`
    const sessionId = `scale-first-turn-${String(size)}`
    const turnStart = performance.now()
    const started = await fetch(`${origin}/api/browser-native/session/durable`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, requestId: `scale-${String(size)}`, sessionId, turnId, prompt: 'scale first turn' }),
    })
    assert.equal(started.status, 202)
    let status
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const response = await fetch(`${origin}/api/browser-native/session/durable?turnId=${turnId}`, { headers: { cookie: owner.cookie } })
      assert.equal(response.status, 200)
      status = await response.json()
      if (status.status !== 'running') break
      await new Promise(resolve => setTimeout(resolve, 2))
    }
    assert.notEqual(status.status, 'running', 'first turn did not settle')
    const turnMs = performance.now() - turnStart
    return { coldMs, turnMs }
  } finally {
    await app.close()
  }
}

test('cold start stays within budget at 1,000 Sessions', { timeout: 300_000 }, async () => {
  const root = await remember('dsh-startup-scale-')
  const base = join(root, 'base')
  await seedInfrastructure(base)

  const results = []
  for (const size of SIZES) {
    const dataDir = join(root, `sessions-${String(size)}`)
    await cp(base, dataDir, { recursive: true })
    await writeSessions(dataDir, size)
    const load = await measureStoreLoad(dataDir)
    assert.equal(load.loaded, size, `store.load() must load every Session at size ${String(size)}`)
    const startup = await measureStartup(dataDir, size)
    const result = { size, ...load, ...startup }
    results.push(result)
    process.stderr.write(`startup scale: sessions=${String(size)} events=${String(EVENTS_PER_SESSION)} `
      + `loadMs=${result.loadMs.toFixed(1)} loadHeapMiB=${(result.heapDelta / MiB).toFixed(1)} `
      + `coldMs=${result.coldMs.toFixed(1)} firstTurnMs=${result.turnMs.toFixed(1)}\n`)
  }

  const largest = results.find(result => result.size === LARGEST)
  assert.ok(largest.loadMs <= LOAD_BUDGET_MS, `store.load() ${largest.loadMs.toFixed(1)}ms > ${String(LOAD_BUDGET_MS)}ms`)
  assert.ok(largest.heapDelta <= HEAP_BUDGET_BYTES, `store.load() heap ${String(largest.heapDelta)}B > ${String(HEAP_BUDGET_BYTES)}B`)
  assert.ok(largest.coldMs <= COLD_BUDGET_MS, `cold start ${largest.coldMs.toFixed(1)}ms > ${String(COLD_BUDGET_MS)}ms`)
  assert.ok(largest.turnMs <= TURN_BUDGET_MS, `first turn ${largest.turnMs.toFixed(1)}ms > ${String(TURN_BUDGET_MS)}ms`)

  const small = results.find(result => result.size === SIZES[Math.max(0, SIZES.length - 2)])
  if (small !== undefined && small.size > 0 && small.size < largest.size && small.loadMs > 0) {
    const ratio = largest.loadMs / small.loadMs
    assert.ok(ratio <= 8, `store.load() grew ${ratio.toFixed(2)}x for a ${(largest.size / small.size).toFixed(2)}x Session increase`)
  }
  const perSessionLoadMs = small.size === 0
    ? largest.loadMs / largest.size
    : (largest.loadMs - small.loadMs) / (largest.size - small.size)
  const perSessionHeapBytes = small.size === 0
    ? largest.heapDelta / largest.size
    : (largest.heapDelta - small.heapDelta) / (largest.size - small.size)
  const byLoad = perSessionLoadMs > 0 ? Math.floor(LOAD_BUDGET_MS / perSessionLoadMs) : Number.MAX_SAFE_INTEGER
  const byHeap = perSessionHeapBytes > 0 ? Math.floor(HEAP_BUDGET_BYTES / perSessionHeapBytes) : Number.MAX_SAFE_INTEGER
  process.stderr.write(`startup scale: perSessionLoadMs=${perSessionLoadMs.toFixed(4)} perSessionHeapKiB=${(perSessionHeapBytes / 1024).toFixed(1)} `
    + `sessionLimitByLoad=${String(byLoad)} sessionLimitByHeap=${String(byHeap)} bound=${String(Math.min(byLoad, byHeap))}\n`)
})
